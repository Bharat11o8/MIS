"""
AutoForm MIS — Updated SQLAlchemy ORM Models (Phase 3)
"""
import uuid
from sqlalchemy import Column, String, Boolean, Integer, Date, Text, ForeignKey, Numeric
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func
from sqlalchemy import TIMESTAMP
from database import Base


class User(Base):
    __tablename__ = "users"

    id                   = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name                 = Column(String(100), nullable=False)
    email                = Column(String(150), unique=True, nullable=False)
    password_hash        = Column(Text, nullable=False)
    role                 = Column(String(50), nullable=False)
    department           = Column(String(100))
    is_active            = Column(Boolean, default=True)
    must_change_password  = Column(Boolean, default=False)
    reset_otp             = Column(String(6), nullable=True)
    reset_otp_expires_at  = Column(TIMESTAMP(timezone=True), nullable=True)
    created_by            = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at            = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at            = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


class Lead(Base):
    __tablename__ = "leads"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    lead_date       = Column(Date, nullable=False)
    source          = Column(String(30), nullable=False)
    customer_name   = Column(String(200))
    mobile_number   = Column(String(20))
    car_type        = Column(String(100))
    product_type    = Column(String(200))
    location        = Column(String(200))
    state           = Column(String(100))
    call_status     = Column(String(50))
    reason          = Column(Text)
    reason_category = Column(String(50))
    assigned_asm    = Column(String(100))
    review_status   = Column(String(50))
    review_reason   = Column(Text)
    upload_log_id   = Column(UUID(as_uuid=True), ForeignKey("upload_logs.id", ondelete="SET NULL"), nullable=True)
    uploaded_by     = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())


class UploadLog(Base):
    __tablename__ = "upload_logs"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    module        = Column(String(50), nullable=False)
    filename      = Column(String(255), nullable=False)
    rows_total    = Column(Integer, default=0)
    rows_success  = Column(Integer, default=0)
    rows_failed   = Column(Integer, default=0)
    status        = Column(String(30), default="Processing")
    error_details = Column(Text)
    uploaded_by   = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    uploaded_at   = Column(TIMESTAMP(timezone=True), server_default=func.now())


class PlantToDepotSale(Base):
    __tablename__ = "plant_to_depot_sales"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sale_year     = Column(Integer, nullable=False)
    sale_month    = Column(Integer, nullable=False)
    depot         = Column(String(50), nullable=False)
    brand         = Column(String(20), nullable=False)
    category      = Column(String(30), nullable=False)
    qty           = Column(Numeric(12, 2))
    rate          = Column(Numeric(12, 2))
    amount        = Column(Numeric(14, 2), nullable=False)
    sync_log_id   = Column(UUID(as_uuid=True), ForeignKey("sync_logs.id", ondelete="SET NULL"), nullable=True)
    created_at    = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at    = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


class SheetSource(Base):
    __tablename__ = "sheet_sources"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    module        = Column(String(50), nullable=False)
    sheet_id      = Column(String(100), nullable=False)
    label         = Column(String(100), nullable=False)
    calendar_year = Column(Integer, nullable=False)
    created_by    = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at    = Column(TIMESTAMP(timezone=True), server_default=func.now())


class DistributorSale(Base):
    __tablename__ = "distributor_sales"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sheet_source_id = Column(UUID(as_uuid=True), ForeignKey("sheet_sources.id", ondelete="CASCADE"), nullable=False)
    entity_type     = Column(String(20), nullable=False)
    distributor     = Column(String(150), nullable=False)
    area_head       = Column(String(100), nullable=True)
    target          = Column(Numeric(14, 2), nullable=True)
    sale_year       = Column(Integer, nullable=False)
    sale_month      = Column(Integer, nullable=False)
    category        = Column(String(10), nullable=False)
    amount          = Column(Numeric(14, 2), nullable=False)
    sync_log_id     = Column(UUID(as_uuid=True), ForeignKey("sync_logs.id", ondelete="SET NULL"), nullable=True)
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at      = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


class SyncLog(Base):
    __tablename__ = "sync_logs"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    module        = Column(String(50), nullable=False, default="sales_plant_to_depot")
    source_label  = Column(String(255))
    rows_total    = Column(Integer, default=0)
    rows_inserted = Column(Integer, default=0)
    rows_updated  = Column(Integer, default=0)
    rows_failed   = Column(Integer, default=0)
    rows_deleted  = Column(Integer, default=0)
    status        = Column(String(30), default="Processing")
    error_details = Column(Text)
    synced_by     = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    synced_at     = Column(TIMESTAMP(timezone=True), server_default=func.now())
